FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY agents ./agents
RUN npm ci --omit=dev

USER node
CMD ["npm", "run", "retrieval:start"]
