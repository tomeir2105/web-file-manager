FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_BIND_HOST=0.0.0.0

EXPOSE 3000 3001

CMD ["npm", "start"]
