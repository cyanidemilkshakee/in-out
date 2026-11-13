"""Narrow TCP relay for invitation SMTP; only the configured mail host is reachable."""
from __future__ import annotations

import asyncio
import logging
import os


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("mail-egress-relay")

UPSTREAM_HOST = os.environ.get("MAIL_RELAY_UPSTREAM_HOST", "").strip()
UPSTREAM_PORT = int(os.environ.get("MAIL_RELAY_UPSTREAM_PORT", "587"))
BIND_HOST = "0.0.0.0"
BIND_PORT = 2525
MAX_CONNECTIONS = 16
CONNECT_TIMEOUT_SECONDS = 10
IDLE_TIMEOUT_SECONDS = 180
_connection_limit = asyncio.Semaphore(MAX_CONNECTIONS)


async def _copy(source: asyncio.StreamReader, destination: asyncio.StreamWriter) -> None:
    while True:
        data = await asyncio.wait_for(source.read(65_536), timeout=IDLE_TIMEOUT_SECONDS)
        if not data:
            return
        destination.write(data)
        await destination.drain()


async def _handle_client(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
) -> None:
    if not UPSTREAM_HOST:
        logger.warning("SMTP relay has no upstream host configured")
        client_writer.close()
        await asyncio.gather(client_writer.wait_closed(), return_exceptions=True)
        return

    async with _connection_limit:
        upstream_writer: asyncio.StreamWriter | None = None
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT),
                timeout=CONNECT_TIMEOUT_SECONDS,
            )
            downstream = asyncio.create_task(_copy(upstream_reader, client_writer))
            upstream = asyncio.create_task(_copy(client_reader, upstream_writer))
            tasks = {downstream, upstream}
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        except (OSError, asyncio.TimeoutError) as error:
            # Do not log message contents or SMTP credentials.
            logger.warning("SMTP upstream connection failed (%s)", type(error).__name__)
        finally:
            client_writer.close()
            if upstream_writer is not None:
                upstream_writer.close()
            await asyncio.gather(
                client_writer.wait_closed(),
                *([upstream_writer.wait_closed()] if upstream_writer is not None else []),
                return_exceptions=True,
            )


async def main() -> None:
    if UPSTREAM_PORT not in {465, 587}:
        raise ValueError("SMTP relay upstream port must be 465 or 587")
    if UPSTREAM_HOST:
        logger.info("SMTP egress relay configured for %s:%s", UPSTREAM_HOST, UPSTREAM_PORT)
    else:
        logger.warning("SMTP egress relay is idle until an SMTP host is configured")
    server = await asyncio.start_server(_handle_client, BIND_HOST, BIND_PORT, limit=65_536)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
