# syntax=docker/dockerfile:1
# `backend` is supplied as a Compose additional build context (service:db-provision).
# No source build or package installation: copy the official, pinned SQL tool only.
FROM temporalio/admin-tools:1.32.2@sha256:4a95866efba29d7e17ab012df5232795e8b0ad0f7d5f9d1ec4df321f7792a754 AS tools
FROM backend
COPY --from=tools /usr/local/bin/temporal-sql-tool /usr/local/bin/temporal-sql-tool
COPY --from=tools /etc/temporal/schema /etc/temporal/schema
COPY initialize_schema.py /maintenance/temporal/initialize_schema.py
CMD ["python", "/maintenance/temporal/initialize_schema.py"]
