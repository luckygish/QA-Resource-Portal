FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV MYSKILLS_NO_OPEN=1

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
EXPOSE 3200
CMD ["node", "server.js"]