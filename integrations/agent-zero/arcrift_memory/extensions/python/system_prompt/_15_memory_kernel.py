from helpers import files, plugins
from helpers.extension import Extension


class ArcRiftMemoryKernel(Extension):
    async def execute(self, system_prompt: list[str] = [], **kwargs):
        if not self.agent:
            return
        config = plugins.get_plugin_config("arcrift_memory", agent=self.agent) or {}
        if not config.get("enabled", True):
            return
        kernel_file = files.get_abs_path(
            "usr/plugins/arcrift_memory/prompts", "arcrift.memory.kernel.md"
        )
        if files.exists(kernel_file):
            system_prompt.append(files.read_file(kernel_file))
