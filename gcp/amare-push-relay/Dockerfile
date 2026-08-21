FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.mjs ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.mjs"]
