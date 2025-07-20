const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Sample route
app.get('/', (req, res) => {
    res.send('Parcel Server is running');
});

// Start the server
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});