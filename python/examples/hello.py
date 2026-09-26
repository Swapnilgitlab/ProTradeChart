"""Checks the connection to ProTradeChart and shows a few bars.

Run it from the Python tab. It uses the first data source you have set up under
Data providers (Zerodha or Dhan).
"""

import protrade as pt

print("Connected to ProTradeChart", pt.status()["app"])

sources = pt.providers()
print(sources.to_string(index=False))

ready = sources[sources["usable"] & sources["id"].isin(["zerodha", "dhan"])]
if ready.empty:
    print(
        "\nNo broker is set up yet. Open Data providers in the app, enter your "
        "credentials, log in, and switch it on."
    )
else:
    broker = ready.iloc[0]["id"]
    symbol = f"{broker}:NSE:RELIANCE"
    bars = pt.bars(symbol, "D", limit=5)
    print(f"\nThe last {len(bars)} daily bars of {symbol}:")
    print(bars)
