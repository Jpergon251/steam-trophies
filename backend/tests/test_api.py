import unittest

import httpx

from app.main import app


class CorsTests(unittest.IsolatedAsyncioTestCase):
    async def test_localhost_ip_is_allowed_for_development(self):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.options(
                "/api/steam/search",
                headers={
                    "Origin": "http://127.0.0.1:5173",
                    "Access-Control-Request-Method": "GET",
                },
            )

        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://127.0.0.1:5173",
        )


if __name__ == "__main__":
    unittest.main()
