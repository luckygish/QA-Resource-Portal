FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
# В Docker используется PostgreSQL, автооткрытие браузера не требуется.
ENV PORTAL_NO_OPEN=1

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
EXPOSE 3001
CMD ["node", "server.js"]