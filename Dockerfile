FROM eclipse-temurin:17-jdk-jammy AS jdk

# Resolve the Spring Boot jars at build time: submissions run without network access.
FROM maven:3.9.16-eclipse-temurin-17 AS spring
WORKDIR /build
COPY spring-boot/pom.xml ./
RUN mvn -B -q dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=/opt/spring-boot/lib
# Project runs (src/project.js) also get JPA and H2, in their own folder.
COPY spring-boot/project/pom.xml ./project/
RUN mvn -B -q -f project/pom.xml dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=/opt/spring-boot/project-lib

FROM node:24-bookworm-slim

COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --from=spring /usr/share/maven /opt/maven
COPY --from=spring /opt/spring-boot/lib /opt/spring-boot/lib
COPY --from=spring /opt/spring-boot/project-lib /opt/spring-boot/project-lib
ENV JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/opt/maven \
    SPRING_BOOT_LIB=/opt/spring-boot/lib \
    SPRING_BOOT_PROJECT_LIB=/opt/spring-boot/project-lib \
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
