import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./transport.js";

const config = loadConfig();
const app = createApp();

app.listen(config.PORT, () => {
	logger.info("LexCerta MCP server listening on port", config.PORT);
});
