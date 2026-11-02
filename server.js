const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Forbindelse til Neon Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Påkrævet for Neon/Render
  }
});

// TEST ROUTE: Tjek om serveren lever
app.get('/', (req, res) => {
  res.send('Handball Stats API kører! 🤾');
});

// 1. START NY KAMP: Opretter kamp og gemmer målmændene i truppen
app.post('/api/matches/start', async (req, res) => {
  const { league, homeTeam, awayTeam, goalkeepers } = req.body;

  try {
    await pool.query('BEGIN');

    // Opret selve kampen i matches-tabellen
    const matchResult = await pool.query(
      'INSERT INTO matches (league, home_team, away_team, is_active) VALUES ($1, $2, $3, true) RETURNING id',
      [league, homeTeam, awayTeam]
    );
    const matchId = matchResult.rows[0].id;

    // Gem tilknyttede målmænd til kampen i match_goalkeepers
    if (goalkeepers && Array.isArray(goalkeepers)) {
      for (const gk of goalkeepers) {
        await pool.query(
          'INSERT INTO match_goalkeepers (match_id, gk_id, gk_name) VALUES ($1, $2, $3)',
          [matchId, gk.id, gk.name]
        );
      }
    }

    await pool.query('COMMIT');

    console.log(`Ny kamp startet med ID: ${matchId}`);
    res.status(201).json({ matchId });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Fejl ved start af kamp:', err);
    res.status(500).json({ error: 'Kunne ikke oprette kamp' });
  }
});

// 2. GEM KLIK: Registrerer handling knyttet til en specifik målmand
app.post('/api/events', async (req, res) => {
  const { matchId, actionType, goalkeeperId } = req.body;

  if (!matchId) {
    return res.status(400).json({ error: 'matchId er påkrævet' });
  }

  try {
    await pool.query(
      'INSERT INTO match_events (match_id, action_type, goalkeeper_id) VALUES ($1, $2, $3)',
      [matchId, actionType, goalkeeperId || null]
    );

    res.status(201).json({ message: 'Handling gemt' });
  } catch (err) {
    console.error('Fejl ved gemning af klik:', err);
    res.status(500).json({ error: 'Kunne ikke gemme handling' });
  }
});

// 3. HENT HISTORIK: Inkluderer målmændenes individuelle stats
app.get('/api/matches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
          m.id,
          m.league,
          m.home_team,
          m.away_team,
          m.created_at,
          COALESCE(SUM(CASE WHEN e.action_type = 'save' THEN 1 ELSE 0 END), 0) as saves,
          COALESCE(SUM(CASE WHEN e.action_type = 'goal' THEN 1 ELSE 0 END), 0) as goals_against,
          COALESCE(SUM(CASE WHEN e.action_type = 'miss' THEN 1 ELSE 0 END), 0) as missed,
          COALESCE(SUM(CASE WHEN e.action_type = 'team_goal' THEN 1 ELSE 0 END), 0) as team_goals,
          (
              SELECT COALESCE(json_agg(json_build_object(
                  'gk_id', gk.gk_id,
                  'gk_name', gk.gk_name,
                  'saves', (SELECT COUNT(*) FROM match_events ev WHERE ev.match_id = m.id AND ev.goalkeeper_id = gk.gk_id AND ev.action_type = 'save'),
                  'goals_against', (SELECT COUNT(*) FROM match_events ev WHERE ev.match_id = m.id AND ev.goalkeeper_id = gk.gk_id AND ev.action_type = 'goal'),
                  'missed', (SELECT COUNT(*) FROM match_events ev WHERE ev.match_id = m.id AND ev.goalkeeper_id = gk.gk_id AND ev.action_type = 'miss')
              )), '[]')
              FROM match_goalkeepers gk
              WHERE gk.match_id = m.id
          ) as goalkeepers
      FROM matches m
      LEFT JOIN match_events e ON m.id = e.match_id
      GROUP BY m.id
      ORDER BY m.created_at DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Fejl ved hentning af historik:', err);
    res.status(500).json({ error: 'Kunne ikke hente historik' });
  }
});

// 4. UNDO: Sletter det seneste event for den specifikke målmand / handling
app.post('/api/events/undo', async (req, res) => {
  const { matchId, actionType, goalkeeperId } = req.body;

  try {
    let query = `
      DELETE FROM match_events
       WHERE id = (
         SELECT id FROM match_events
         WHERE match_id = $1 AND action_type = $2 
    `;
    const params = [matchId, actionType];

    // Hvis der er et goalkeeperId (og det ikke er tomt/undefined)
    if (goalkeeperId) {
      query += ` AND goalkeeper_id = $3 `;
      params.push(goalkeeperId);
    } else {
      // Hvis det er et holdmål (uden målmand), skal vi tjekke hvor goalkeeper_id er NULL
      query += ` AND goalkeeper_id IS NULL `;
    }

    query += ` ORDER BY timestamp DESC LIMIT 1)`;

    const result = await pool.query(query, params);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ingen handling fundet' });
    }

    res.json({ message: 'Handling fortrudt' });
  } catch (err) {
    console.error('Fejl ved undo:', err);
    res.status(500).json({ error: 'Kunne ikke fortryde' });
  }
});

// 5. SLET KAMP: Fjerner kamp, events og tilhørende målmandstrupper
app.delete('/api/matches/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Anmodning om sletning af kamp ID: ${id}`);

  try {
    await pool.query('BEGIN');

    // 1. Slet tilknyttede målmænd og hændelser først (pga. FK referencer)
    await pool.query('DELETE FROM match_events WHERE match_id = $1', [id]);
    await pool.query('DELETE FROM match_goalkeepers WHERE match_id = $1', [id]);

    // 2. Slet selve kampen
    const result = await pool.query('DELETE FROM matches WHERE id = $1', [id]);

    await pool.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Kampen blev ikke fundet' });
    }

    res.json({ message: 'Kamp og data slettet succesfuldt' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Fejl ved sletning:', err);
    res.status(500).json({ error: 'Server fejl ved sletning' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Serveren kører på port ${PORT}`);
});