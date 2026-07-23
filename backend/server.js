const express = require("express");
const routes = require("./routes");

const app = express();
app.use(express.json());

// Allow the Chrome extension (running in the context of linkedin.com) to
// call this API cross-origin. Without this, every fetch from the extension
// fails with a CORS error before it even reaches our routes.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.linkedin.com");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204); // preflight
  next();
});

// Simple health check so you can confirm Render deployed it correctly
app.get("/", (req, res) => res.json({ ok: true, service: "outreach-backend" }));

app.use("/api", routes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
