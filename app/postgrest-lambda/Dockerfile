# PostgREST Lambda Web Adapter Image
# Fetches config from project-service API (default) or Secrets Manager (legacy)
FROM public.ecr.aws/docker/library/amazonlinux:2
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

# Install runtime dependencies: curl (pre-installed), jq (for JSON)
# openssl only needed if CONFIG_SOURCE=secretsmanager (legacy SigV4 signing)
RUN yum install -y \
    libpq \
    zlib \
    jq \
    && yum clean all

# Copy PostgREST binary
COPY postgrest /usr/bin/postgrest
RUN chmod +x /usr/bin/postgrest

# Copy bootstrap script (replaces inline CMD)
COPY bootstrap.sh /var/task/bootstrap.sh
RUN chmod +x /var/task/bootstrap.sh

EXPOSE 8080
WORKDIR /var/task

# Lambda Web Adapter configuration
ENV PORT=3000
ENV READINESS_CHECK_PORT=3000
ENV READINESS_CHECK_PATH=/
ENV AWS_LWA_ASYNC_INIT=true
ENV AWS_LWA_AUTHORIZATION_SOURCE=X-Client-Authorization

# Config source: "service" (project-service API, default) or "secretsmanager" (legacy)
ENV CONFIG_SOURCE=service
ENV CONFIG_SERVICE_URL=http://tenant-manager.supabase.local:3001

CMD ["/var/task/bootstrap.sh"]
