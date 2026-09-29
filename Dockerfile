FROM eclipse-temurin:17-jdk-jammy AS jdk
FROM node:24-bookworm-slim

COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH="/opt/java/openjdk/bin:${PATH}" \
    NODE_ENV=production \
    EXECUTION_MODE=cloud-run \
    PORT=8080
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
