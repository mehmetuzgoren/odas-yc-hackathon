"""One-time Roborock account commissioning; persists credentials privately for cloud worker startup."""
import argparse
import asyncio
import getpass
import json
import os
from pathlib import Path
from roborock.web_api import RoborockApiClient

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--email', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    api = RoborockApiClient(username=args.email)
    await api.request_code()
    code = getpass.getpass('Roborock email code (hidden): ')
    user = await api.code_login(code)
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(user.as_dict(), handle)
    os.chmod(path, 0o600)
    print('Roborock account credentials saved privately. Physical command commissioning is still required.')

if __name__ == '__main__':
    asyncio.run(main())
