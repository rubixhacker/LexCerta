import { loadConfig } from "./config";
import { logger } from "./logger";
import { createApp } from "./transport";

const config = loadConfig();
const app = createApp(config);

app.listen(config.PORT, () => {
	logger.info("LexCerta MCP server listening on port", config.PORT);
});
