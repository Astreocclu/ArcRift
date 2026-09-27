from agent import LoopData
from helpers import plugins
from helpers.defer import DeferredTask, THREAD_BACKGROUND
from helpers.extension import Extension
from usr.plugins.arcrift_memory.helpers.client import call_memory_tool, latest_exchange, proposal_content, proposal_key


class ArcRiftProposeExchange(Extension):
    def execute(self, loop_data: LoopData = LoopData(), **kwargs):
        if not self.agent or self.agent is not self.agent.context.agent0:
            return
        config = plugins.get_plugin_config("arcrift_memory", agent=self.agent) or {}
        if not config.get("enabled", True) or not config.get("proposal_enabled", True):
            return
        exchange = latest_exchange(self.agent.history.output())
        if not exchange:
            return
        context_id = str(self.agent.context.id)
        key = proposal_key(context_id, exchange)
        timeout = float(config.get("proposal_timeout_seconds", 15))
        task = DeferredTask(thread_name=THREAD_BACKGROUND)
        task.start_task(self._submit, exchange, key, timeout)

    async def _submit(self, exchange: dict[str, str], key: str, timeout: float):
        if not self.agent:
            return
        try:
            await call_memory_tool(
                "memory_propose",
                {"content": proposal_content(exchange), "source": "agent-zero", "idempotencyKey": key},
                agent=self.agent,
                timeout_seconds=max(1, min(timeout, 30)),
            )
        except Exception:
            return
