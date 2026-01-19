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

// 1. START NY KAMP: Opretter række i 'matches' og returnerer ID
app.post('/api/matches/start', async (req, res) => {
  const { league, homeTeam, awayTeam } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO matches (league, home_team, away_team) VALUES ($1, $2, $3) RETURNING id',
      [league, homeTeam, awayTeam]
    );

    console.log(`Ny kamp startet med ID: ${result.rows[0].id}`);
    res.status(201).json({ matchId: result.rows[0].id });
  } catch (err) {
    console.error('Fejl ved start af kamp:', err);
    res.status(500).json({ error: 'Kunne ikke oprette kamp' });
  }
});

// 2. GEM KLIK: Registrerer hver handling (save, goal, miss)
app.post('/api/events', async (req, res) => {
  const { matchId, actionType } = req.body;

  if (!matchId) {
    return res.status(400).json({ error: 'matchId er påkrævet' });
  }

  try {
    await pool.query(
      'INSERT INTO match_events (match_id, action_type) VALUES ($1, $2)',
      [matchId, actionType]
    );

    res.status(201).json({ message: 'Handling gemt' });
  } catch (err) {
    console.error('Fejl ved gemning af klik:', err);
    res.status(500).json({ error: 'Kunne ikke gemme handling' });
  }
});

// 3. HENT HISTORIK (Valgfri): Hvis man vil se tidligere kampe senere
app.get('/api/matches', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM matches ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Kunne ikke hente kampe' });
  }
});

app.post('/api/events/undo', async (req, res) => {
  const { matchId, actionType } = req.body;
  console.log(`Undo modtaget for kamp: ${matchId}, type: ${actionType}`);

  try {
    const result = await pool.query(
      `DELETE FROM match_events
       WHERE id = (
         SELECT id FROM match_events
         WHERE match_id = $1 AND action_type = $2
         ORDER BY timestamp DESC
         LIMIT 1
       )`,
      [matchId, actionType]
    );
    res.json({ message: 'Handling fortrudt' });
  } catch (err) {
    console.error('Fejl ved undo:', err);
    res.status(500).json({ error: 'Kunne ikke fortryde' });
  }
});

const PORT = process.env.PORT || 10000; // Render bruger ofte port 10000
app.listen(PORT, () => {
  console.log(`Serveren kører på port ${PORT}`);
});