import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from main import verify_mtls_terminal
from redis_client import subscribe_presence

class GatewayIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_configured_kong_identity_is_accepted(self):
        secret = 'isolated-test-secret-at-least-32-characters'
        def request(headers):
            return Request({'type': 'http', 'headers': [(k.lower().encode(), v.encode()) for k, v in headers.items()]})
        with patch('main.settings.KONG_TERMINAL_SECRET', secret):
            for headers in ({}, {'X-Client-Verify':'SUCCESS', 'X-Client-DN':'CN=old', 'X-Proxy-Secret':secret},
                {'X-Inout-Terminal-DN':'CN=test', 'X-Inout-Gateway-Secret':'wrong'},
                {'X-Inout-Gateway-Secret':secret}):
                with self.assertRaises(HTTPException):
                    await verify_mtls_terminal(request(headers))
            self.assertEqual(await verify_mtls_terminal(request({
                'X-Inout-Terminal-DN':'CN=test', 'X-Inout-Gateway-Secret':secret})), 'CN=test')

    async def test_idle_presence_stream_emits_heartbeats_and_cleans_up(self):
        pubsub = Mock(subscribe=AsyncMock(), unsubscribe=AsyncMock(), aclose=AsyncMock(),
            get_message=AsyncMock(side_effect=[None, {'type':'message','data':'{"state":"inside"}'}]))
        with patch('redis_client.get_redis_pool', return_value=Mock(pubsub=Mock(return_value=pubsub))):
            stream = subscribe_presence()
            self.assertIsNone(await anext(stream))
            self.assertEqual(await anext(stream), '{"state":"inside"}')
            await stream.aclose()
        pubsub.unsubscribe.assert_awaited_once()
        pubsub.aclose.assert_awaited_once()
