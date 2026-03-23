FROM kong:3.5

# Copy custom plugins to the path Kong looks for them
USER root

# Install envsubst (from gettext-base) for kong.yml.tpl processing
RUN apt-get update && apt-get install -y --no-install-recommends gettext-base && rm -rf /var/lib/apt/lists/*
COPY certs/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

COPY plugins/aws-lambda-sigv4 /usr/local/share/lua/5.1/kong/plugins/aws-lambda-sigv4
COPY plugins/dynamic-lambda-router /usr/local/share/lua/5.1/kong/plugins/dynamic-lambda-router

# Install lua-resty-redis (may not be included in Kong 3.5 base image)
RUN luarocks install lua-resty-redis 2>/dev/null || true

# Fix plugin file permissions and ownership
RUN chown -R kong:kong /usr/local/share/lua/5.1/kong/plugins/aws-lambda-sigv4 && \
    chmod -R 664 /usr/local/share/lua/5.1/kong/plugins/aws-lambda-sigv4/*.lua && \
    chmod 775 /usr/local/share/lua/5.1/kong/plugins/aws-lambda-sigv4 && \
    chown -R kong:kong /usr/local/share/lua/5.1/kong/plugins/dynamic-lambda-router && \
    chmod -R 664 /usr/local/share/lua/5.1/kong/plugins/dynamic-lambda-router/*.lua && \
    chmod 775 /usr/local/share/lua/5.1/kong/plugins/dynamic-lambda-router

# Copy Kong declarative config template (processed by envsubst at container start)
COPY kong.yml.tpl /tmp/kong.yml.tpl

# Copy custom entrypoint for DB-backed mode (migrations + config import)
COPY docker-entrypoint-custom.sh /docker-entrypoint-custom.sh
RUN chmod +x /docker-entrypoint-custom.sh

# Environment variables
# KONG_DATABASE, KONG_PG_HOST, KONG_PG_USER, KONG_PG_PASSWORD, KONG_PG_DATABASE
# are injected by ECS task definition via CDK
ENV KONG_PROXY_LISTEN=0.0.0.0:8000
ENV KONG_ADMIN_LISTEN=0.0.0.0:8001
ENV KONG_LOG_LEVEL=info
ENV KONG_PLUGINS=bundled,dynamic-lambda-router
ENV KONG_UNTRUSTED_LUA=sandbox

USER kong

ENTRYPOINT ["/docker-entrypoint-custom.sh"]
