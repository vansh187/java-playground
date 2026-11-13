FROM eclipse-temurin:17-jdk-jammy AS jdk

# Resolve the Spring Boot jars at build time: submissions run without network access.
FROM maven:3.9.16-eclipse-temurin-17 AS spring
WORKDIR /build
COPY spring-boot/pom.xml ./
RUN mvn -B -q dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=/opt/spring-boot/lib
# Project runs (src/project.js) also get JPA and H2, in their own folder.
COPY spring-boot/project/pom.xml ./project/
RUN mvn -B -q -f project/pom.xml dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=/opt/spring-boot/project-lib

# Packages preinstalled for learners' Node.js code (src/node.js). Pure JavaScript, installed
# without running any package's install scripts.
FROM node:24-bookworm-slim AS nodelibs
WORKDIR /opt/node-libs
COPY node-libs/package.json node-libs/package-lock.json ./
COPY node-libs/local ./local
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim

COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --from=spring /usr/share/maven /opt/maven
COPY --from=spring /opt/spring-boot/lib /opt/spring-boot/lib
COPY --from=spring /opt/spring-boot/project-lib /opt/spring-boot/project-lib
COPY --from=nodelibs /opt/node-libs /opt/node-libs
ENV JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/opt/maven \
    SPRING_BOOT_LIB=/opt/spring-boot/lib \
    SPRING_BOOT_PROJECT_LIB=/opt/spring-boot/project-lib \
    NODE_LIBS=/opt/node-libs \
    PATH="/opt/java/openjdk/bin:/opt/maven/bin:${PATH}" \
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
