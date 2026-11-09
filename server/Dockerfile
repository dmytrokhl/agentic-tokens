FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --production
COPY server/*.js ./
COPY mcp-server/src/v2-payments.js /app/mcp-server/src/v2-payments.js
EXPOSE 3000
CMD ["node", "server.js"]
