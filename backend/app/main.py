import logging

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from app.services.steam import (
    get_owned_games,
    get_player_achievements,
    get_steam_profile,
    search_steam_profile,
)

logger = logging.getLogger(__name__)

app = FastAPI(title="Steam Trophies API")


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/steam/search")
async def steam_search(q: str = Query(..., min_length=1)):
    try:
        return await search_steam_profile(q)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error))

@app.get("/api/steam/profile/{steam_id}/games")
async def steam_games(steam_id: str):
    try:
        return await get_owned_games(steam_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception:
        raise HTTPException(status_code=502, detail="Steam games are not available right now.")

@app.get("/api/steam/profile/{steam_id}/games/{app_id}/achievements")
async def steam_achievements(steam_id: str, app_id: int):
    try:
        return await get_player_achievements(steam_id, app_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        upstream_status = (
            error.response.status_code
            if isinstance(error, httpx.HTTPStatusError)
            else None
        )
        logger.error(
            "Steam achievements request failed for app %s (%s, upstream status: %s)",
            app_id,
            type(error).__name__,
            upstream_status or "n/a",
        )
        raise HTTPException(status_code=502, detail="Steam achievements are not available right now.")

@app.get("/api/steam/profile")
async def steam_profile(steam_id: str = Query(..., min_length=1)):
    try:
        return await get_steam_profile(steam_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error))