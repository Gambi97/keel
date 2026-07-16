FROM node:22-alpine
WORKDIR /app
COPY server.mjs index.html logo.png ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
