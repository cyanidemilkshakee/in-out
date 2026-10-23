# syntax=docker/dockerfile:1
# `backend` is supplied as a Compose additional build context (service:db-provision).
# No source build or package installation: copy the official, pinned SQL tool only.
FROM temporalio/admin-tools:1.32.1@sha256:9ef0dc5b063bf4ffd5c1512de72e0e73e225bd2c7006a18ce69bd592a8862a83 AS tools
FROM backend
COPY --from=tools /usr/local/bin/temporal-sql-tool /usr/local/bin/temporal-sql-tool
COPY --from=tools /etc/temporal/schema /etc/temporal/schema
COPY initialize_schema.py /maintenance/temporal/initialize_schema.py
CMD ["python", "/maintenance/temporal/initialize_schema.py"]
