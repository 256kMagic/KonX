import { h, icon, contextMenu, toast, errMsg } from './ui.js';
import { TrafficEvidenceOwner, trafficContextChoices, captureTrafficContext } from './copilot-traffic.mjs';

export function installTrafficContext(tab) {
  tab.copilot = new TrafficEvidenceOwner(tab);
  tab.copilotContextChoices = () => trafficContextChoices(tab);
  tab.captureCopilotContext = options => captureTrafficContext(tab, options);
}

export function trafficCopilotButton(tab) {
  return tab.copilotButton = h('button.btn.sm', { 'aria-label': 'Ask Copilot about this evidence', onclick: event => {
    const rect = event.currentTarget.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom, tab.copilotContextChoices().map(choice => ({ label: choice.label, disabled: choice.disabled, action: () => {
      try { tab.app.openCopilot(tab, { snapshot: tab.captureCopilotContext({ choice: choice.choice }), question: 'Explain this evidence. Separate observations, unknowns and possible causes, and suggest checks I can choose to perform.' }); }
      catch (error) { toast(errMsg(error), 'err'); }
    } })));
  } }, icon('insight'), 'Ask Copilot');
}
