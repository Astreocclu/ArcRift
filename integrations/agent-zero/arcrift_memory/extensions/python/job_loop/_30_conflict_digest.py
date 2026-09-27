from helpers.extension import Extension
from usr.plugins.arcrift_memory.helpers.digest import run_digest_tick


class ArcRiftConflictDigest(Extension):
    async def execute(self, **kwargs):
        try:
            await run_digest_tick()
        except Exception:
            return
