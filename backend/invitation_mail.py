"""Send app-owned, one-time Zoho sign-in invitations over configured SMTP."""
from __future__ import annotations

import asyncio
import html
import socket
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import quote, urlsplit

from fastapi import HTTPException

from config import settings


class _RelayedSMTP(smtplib.SMTP):
    """Connect through the private relay but keep the public SMTP host for TLS."""

    def _get_socket(self, host: str, port: int, timeout: float | None):
        if not settings.INVITE_SMTP_PROXY_HOST:
            return super()._get_socket(host, port, timeout)
        return socket.create_connection(
            (settings.INVITE_SMTP_PROXY_HOST, settings.INVITE_SMTP_PROXY_PORT), timeout
        )


class _RelayedSMTPSSL(smtplib.SMTP_SSL):
    """Tunnel implicit TLS while validating the Zoho server certificate."""

    def _get_socket(self, host: str, port: int, timeout: float | None):
        if not settings.INVITE_SMTP_PROXY_HOST:
            return super()._get_socket(host, port, timeout)
        raw_socket = socket.create_connection(
            (settings.INVITE_SMTP_PROXY_HOST, settings.INVITE_SMTP_PROXY_PORT), timeout
        )
        try:
            context = self.context or ssl.create_default_context()
            return context.wrap_socket(raw_socket, server_hostname=self._host)
        except Exception:
            raw_socket.close()
            raise


def _validate_mail_configuration() -> None:
    if not settings.INVITE_SMTP_HOST or not settings.INVITE_SMTP_FROM or not settings.INVITE_APP_BASE_URL:
        raise HTTPException(503, "Invitation email is not configured. Set the invite mail sender and application URL first.")
    try:
        app_url = urlsplit(settings.INVITE_APP_BASE_URL)
        hostname = app_url.hostname or ""
        valid_local_http = hostname == "localhost" or hostname.endswith(".localhost") or hostname in {"127.0.0.1", "::1"}
        if (app_url.scheme not in {"http", "https"} or not hostname or app_url.username or app_url.password or
                app_url.path not in {"", "/"} or app_url.query or app_url.fragment or
                (app_url.scheme != "https" and not valid_local_http)):
            raise ValueError
        _ = app_url.port
    except ValueError as error:
        raise HTTPException(503, "The invitation application URL must be a valid HTTPS origin (HTTP is allowed for localhost development).") from error
    if settings.INVITE_SMTP_SSL and settings.INVITE_SMTP_STARTTLS:
        raise HTTPException(503, "Invitation email security settings are invalid.")
    if settings.INVITE_SMTP_AUTH and not (settings.INVITE_SMTP_USER and settings.INVITE_SMTP_PASSWORD):
        raise HTTPException(503, "Invitation email credentials are not configured.")


def ensure_invitation_mail_ready() -> None:
    _validate_mail_configuration()


def _compose_invitation(recipient: str, display_name: str, invite_url: str) -> EmailMessage:
    safe_name = html.escape(display_name or recipient)
    safe_url = html.escape(invite_url, quote=True)
    ttl_minutes = max(1, (settings.INVITE_TTL_SECONDS + 59) // 60)
    message = EmailMessage()
    message["Subject"] = "You are invited to InOut Management"
    message["From"] = formataddr((settings.INVITE_SMTP_DISPLAY_NAME, settings.INVITE_SMTP_FROM))
    message["To"] = recipient
    message.set_content(
        f"You have been invited to InOut Management.\n\n"
        f"Accept the invitation within {ttl_minutes} minutes using this link:\n{invite_url}\n\n"
        "After accepting, continue with your Zoho company sign-in. This link can be used once.\n"
    )
    message.add_alternative(
        "<!doctype html><html><body>"
        f"<p>Hello {safe_name},</p><p>You have been invited to InOut Management.</p>"
        f"<p><a href=\"{safe_url}\">Accept invitation</a></p>"
        f"<p>This link expires in {ttl_minutes} minutes and can be used once. "
        "After accepting, continue with your Zoho company sign-in.</p>"
        "</body></html>",
        subtype="html",
    )
    return message


def _send(message: EmailMessage) -> None:
    context = ssl.create_default_context()
    try:
        if settings.INVITE_SMTP_SSL:
            with _RelayedSMTPSSL(settings.INVITE_SMTP_HOST, settings.INVITE_SMTP_PORT,
                                 timeout=10, context=context) as client:
                if settings.INVITE_SMTP_AUTH:
                    client.login(settings.INVITE_SMTP_USER, settings.INVITE_SMTP_PASSWORD)
                client.send_message(message)
        else:
            with _RelayedSMTP(settings.INVITE_SMTP_HOST, settings.INVITE_SMTP_PORT,
                              timeout=10) as client:
                client.ehlo()
                if settings.INVITE_SMTP_STARTTLS:
                    client.starttls(context=context)
                    client.ehlo()
                if settings.INVITE_SMTP_AUTH:
                    client.login(settings.INVITE_SMTP_USER, settings.INVITE_SMTP_PASSWORD)
                client.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        raise HTTPException(503, "The invitation was saved, but the email could not be delivered. Resend it after checking mail settings.") from error


async def send_invitation(recipient: str, display_name: str, user_id: str, token: str) -> None:
    _validate_mail_configuration()
    base = settings.INVITE_APP_BASE_URL.rstrip("/")
    # A fragment keeps the bearer secret out of HTTP request logs and referrers.
    invite_url = f"{base}/invite/accept#u={quote(user_id, safe='')}&t={quote(token, safe='')}"
    message = _compose_invitation(recipient, display_name, invite_url)
    await asyncio.to_thread(_send, message)
