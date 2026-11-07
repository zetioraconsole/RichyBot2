FROM node:20-slim

# Sakinisha dependencies zinazohitajika na Baileys/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Weka folda ya sessions tayari
RUN mkdir -p /app/sessions

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
