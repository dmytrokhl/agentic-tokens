FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js vgs.js card-surface.js otp.js ./
EXPOSE 3000
CMD ["node", "server.js"]
