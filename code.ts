// Replace these with your actual API key and site details
const OPENROUTER_API_KEY = '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';

figma.showUI(__html__, { width: 300, height: 200 });

figma.ui.postMessage({ type: 'init', layerCount: figma.currentPage.selection.length });

figma.on('selectionchange', () => {
  const selectedLayers = figma.currentPage.selection;
  const totalLayers = selectedLayers.reduce((sum, node) => sum + countLayers(node), 0);
  figma.ui.postMessage({ 
    type: 'selectionUpdate', 
    selectedCount: selectedLayers.length,
    totalCount: totalLayers
  });
});

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  content: string;
  children: LayerInfo[];
}

function getLayerInfo(node: SceneNode): LayerInfo {
  let content = '';
  if ('characters' in node && node.characters.trim() !== '') {
    content = node.characters;
  } else if ('fills' in node && Array.isArray(node.fills) && node.fills.length > 0) {
    content = 'Filled shape';
  } else {
    content = node.type;
  }

  const layerInfo: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    content: content,
    children: []
  };

  if ('children' in node) {
    layerInfo.children = node.children.map(child => getLayerInfo(child));
  }

  return layerInfo;
}

function countLayers(node: SceneNode | LayerInfo): number {
  let count = 1;
  if ('children' in node) {
    count += node.children.reduce((sum, child) => sum + countLayers(child), 0);
  }
  return count;
}

figma.ui.onmessage = async (msg: { type: string }) => {
  if (msg.type === 'start-renaming') {
    try {
      const selection = figma.currentPage.selection;

      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'complete' });
        return;
      }

      const layerInfos = selection.map(node => getLayerInfo(node));
      const totalLayers = layerInfos.reduce((sum, info) => sum + countLayers(info), 0);

      figma.ui.postMessage({ type: 'layerCount', count: totalLayers });

      const contextDescription = `This is a user interface for a messaging application. 
The selected elements appear to be part of a message component. 
Please consider the hierarchy and purpose of each element when renaming.`;

      const prompt = `${contextDescription}

Rename the following UI layers based on their context and hierarchy:

${JSON.stringify(layerInfos, null, 2)}

Provide concise and descriptive names for each layer, maintaining the hierarchy. 
The response should be in the format:
1. NewNameOne
   1.1 ChildNameOne
   1.2 ChildNameTwo
2. NewNameTwo
...`;

      const payload = {
        model: 'mattshumer/reflection-70b:free',
        messages: [
          { role: 'user', content: prompt },
        ],
      };

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const aiMessage = data.choices[0]?.message?.content;

      if (!aiMessage) {
        throw new Error('No response from AI model');
      }

      console.log('AI response:', aiMessage); // Add this line for debugging

      const newNames = aiMessage.trim().split('\n').map((line: string) => {
        const match = line.match(/^(\d+(\.\d+)*)\.\s*(.+)$/);
        return match ? { level: match[1], name: match[3].trim() } : null;
      }).filter((item: { level: string; name: string } | null): item is { level: string; name: string } => item !== null);

      if (newNames.length === 0) {
        throw new Error('Failed to parse AI response');
      }

      function renameLayer(layerInfo: LayerInfo, names: { level: string; name: string }[], prefix: string = '') {
        const currentName = names.find(n => n.level === prefix + '1');
        if (currentName) {
          const node = figma.getNodeById(layerInfo.id) as SceneNode;
          if (node) {
            node.name = currentName.name;
          }
        }

        layerInfo.children.forEach((child, index) => {
          renameLayer(child, names, prefix ? `${prefix}${index + 1}.` : `${index + 1}.`);
        });
      }

      layerInfos.forEach((layerInfo, index) => {
        renameLayer(layerInfo, newNames, `${index + 1}.`);
        figma.ui.postMessage({ type: 'progress', current: index + 1, total: layerInfos.length });
      });

      figma.ui.postMessage({ type: 'complete' });
    } catch (error: unknown) {
      console.error('Error:', error);
      figma.ui.postMessage({ type: 'error', message: (error as Error).message });
    }
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  } else if (msg.type === 'requestSelection') {
    const selectedLayers = figma.currentPage.selection;
    const totalLayers = selectedLayers.reduce((sum, node) => sum + countLayers(node), 0);
    figma.ui.postMessage({ 
      type: 'selectionUpdate', 
      selectedCount: selectedLayers.length,
      totalCount: totalLayers
    });
  }
};


