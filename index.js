const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Log function
function logMessage(message, type = "INFO") {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type}] ${message}\n`;
  console.log(logEntry.trim());

  // Append to log file
  const logFile = path.join(
    logsDir,
    `whatsapp-${new Date().toISOString().split("T")[0]}.log`,
  );
  fs.appendFileSync(logFile, logEntry);
}

// Create a new client instance
// Using Puppeteer's built-in Chromium (no need to specify executablePath)
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, "auth-data"), // Store session data locally
  }),
  puppeteer: {
    // Chrome for Testing downloaded into ./chrome (not in Puppeteer's default cache)
    executablePath: path.join(
      __dirname,
      "chrome",
      "win64-146.0.7680.31",
      "chrome-win64",
      "chrome.exe",
    ),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    // Optional: Increase timeout for slower servers
    timeout: 60000,
    // Optional: For debugging (set to true to see browser console)
    dumpio: false,
  },
});

// When the client is ready
client.once("ready", () => {
  logMessage("✅ Client is ready!", "SUCCESS");
  logMessage(`WhatsApp Web is connected and authenticated`, "INFO");
});

// When the client received QR-Code
client.on("qr", (qr) => {
  logMessage("📱 SCAN THIS QR CODE WITH WHATSAPP", "INFO");
  console.log("\n");
  qrcode.generate(qr, { small: false });
  console.log("\n");
  logMessage(`QR code generated at ${new Date().toISOString()}`, "INFO");

  // Save QR code to file for easy access
  const qrFile = path.join(__dirname, "logs", `qr-${Date.now()}.txt`);
  fs.writeFileSync(qrFile, qr);
  logMessage(`QR code saved to ${qrFile}`, "INFO");
});

// Handle authentication failures
client.on("auth_failure", (msg) => {
  logMessage(`❌ Authentication failed: ${msg}`, "ERROR");
});

// Handle disconnections with auto-reconnect
client.on("disconnected", (reason) => {
  logMessage(`🔌 Client disconnected: ${reason}`, "WARN");
  logMessage("Attempting to reconnect in 5 seconds...", "INFO");

  setTimeout(() => {
    logMessage("Reconnecting...", "INFO");
    client.initialize().catch((err) => {
      logMessage(`❌ Reconnection failed: ${err.message}`, "ERROR");
      process.exit(1);
    });
  }, 5000);
});

// Error handling
client.on("error", (error) => {
  logMessage(`❌ An error occurred: ${error.message}`, "ERROR");
  if (error.stack) {
    logMessage(`Stack trace: ${error.stack}`, "ERROR");
  }
});

// Handle process termination
process.on("SIGINT", async () => {
  logMessage("Received SIGINT. Shutting down...", "INFO");
  await client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logMessage("Received SIGTERM. Shutting down...", "INFO");
  await client.destroy();
  process.exit(0);
});

// Unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logMessage(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "ERROR");
});

// Uncaught exceptions
process.on("uncaughtException", (error) => {
  logMessage(`Uncaught Exception: ${error.message}`, "ERROR");
  if (error.stack) {
    logMessage(`Stack trace: ${error.stack}`, "ERROR");
  }
  // Keep the process running, but log the error
});

// Start your client
async function initializeClient() {
  try {
    logMessage("🚀 Initializing WhatsApp Web client...", "INFO");
    logMessage("Using Chrome for Testing from ./chrome", "INFO");

    await client.initialize();
    logMessage("✅ Client initialized successfully", "SUCCESS");
  } catch (err) {
    logMessage(`❌ Failed to initialize client: ${err.message}`, "ERROR");
    if (err.stack) {
      logMessage(`Stack trace: ${err.stack}`, "ERROR");
    }
    process.exit(1);
  }
}

// Memory monitoring
setInterval(() => {
  const used = process.memoryUsage();
  const memoryUsage = {
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024),
  };
  logMessage(`💾 Memory usage: ${JSON.stringify(memoryUsage)} MB`, "DEBUG");
}, 300000); // Every 5 minutes

// Start the client
initializeClient();

// Export client for use in other modules
module.exports = client;
