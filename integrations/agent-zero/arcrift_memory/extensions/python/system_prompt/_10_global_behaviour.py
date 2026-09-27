from helpers import files, plugins, projects
from helpers.extension import Extension


class ArcRiftGlobalBehaviour(Extension):
    async def execute(self, system_prompt: list[str] = [], **kwargs):
        if not self.agent:
            return
        config = plugins.get_plugin_config("arcrift_memory", agent=self.agent) or {}
        if not config.get("enabled", True) or not config.get("global_behaviour_enabled", True):
            return
        if not projects.get_context_project_name(self.agent.context):
            return
        global_rules = files.get_abs_path("usr/memory/default", "behaviour.md")
        if files.exists(global_rules):
            rules = files.read_file(global_rules)
            system_prompt.append(self.agent.read_prompt("agent.system.behaviour.md", rules=rules))
