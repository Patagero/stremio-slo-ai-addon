FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
COPY test ./test
EXPOSE 7002
CMD ["npm","start"]
