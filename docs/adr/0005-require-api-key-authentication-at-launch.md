# Require API key authentication at launch

The public LexCerta MCP endpoint will require a LexCerta API key from its first deployment. Anonymous access is rejected because every tool call consumes shared service capacity and may consume the private CourtListener quota; authentication therefore precedes global rate limiting, usage metering, and any later billing workflow.
