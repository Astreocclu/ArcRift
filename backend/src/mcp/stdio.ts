process.env.ARCRIFT_MCP_MODE = "true";

import("./server")
  .then(({ runStdioServer }) => runStdioServer())
  .catch(error => {
    process.stderr.write(`[ArcRift MCP] Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
