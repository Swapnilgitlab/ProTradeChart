"""Checks the connection to ProTradeChart and shows a few bars.

Run it from the Python tab. It uses your broker (Zerodha or FYERS), once you have
set it up under Data providers.
"""

import protrade as pt

print("Connected to ProTradeChart", pt.status()["app"])

sources = pt.providers()
print(sources.to_string(index=False))

ready = sources[sources["usable"] & sources["id"].isin(["india"])]
if ready.empty:
    print(
        "\nNo broker is set up yet. Open Data providers in the app, enter your "
        "credentials, log in, and switch it on."
    )
else:
    symbol = "india:NSE:RELIANCE"
    bars = pt.bars(symbol, "D", limit=5)
    print(f"\nThe last {len(bars)} daily bars of {symbol}:")
    print(bars)
