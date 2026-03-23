FROM supabase/edge-runtime:v1.69.28

COPY main-router.ts /tmp/main-router.ts
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
