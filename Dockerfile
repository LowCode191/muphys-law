# muphys-law MCP server (stdio). Zero dependencies — the image is just Node + source.
FROM node:20-slim
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY lib/ lib/
COPY bin/ bin/
COPY hooks/ hooks/
COPY templates/ templates/
COPY data/sample-lessons.jsonl data/projects.example.json data/
# Register home lives outside the image; mount or let it default to ~/.muphys
CMD ["node", "lib/register.cjs"]
