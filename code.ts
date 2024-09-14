// Replace these with your actual API key and site details
const OPENROUTER_API_KEY = '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';

figma.showUI(__html__, { width: 300, height: 200 });

figma.ui.postMessage({ type: 'init', layerCount: figma.currentPage.selection.length });

figma.on('selectionchange', () => {
  const selectedLayers = figma.currentPage.selection;
  figma.ui.postMessage({ 
    type: 'selectionUpdate', 
    layerCount: selectedLayers.length 
  });
});
  
function getAllLayers(node: SceneNode): SceneNode[] {
  let layers: SceneNode[] = [node];
  if ('children' in node) {
    for (const child of node.children) {
      layers = layers.concat(getAllLayers(child));
    }
  }
  return layers;
}

figma.ui.onmessage = async (msg: { type: string }) => {
  if (msg.type === 'start-renaming') {
    try {
      const selection = figma.currentPage.selection;

      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'complete' });
        return;
      }

      const allLayers: SceneNode[] = selection.reduce((acc: SceneNode[], node: SceneNode) => {
        return acc.concat(getAllLayers(node));
      }, []);

      const layerData = allLayers.map((node: SceneNode, index: number) => {
        let content = '';

        if ('characters' in node && node.characters.trim() !== '') {
          content = node.characters;
        } else if ('name' in node && node.name.trim() !== '') {
          content = node.name;
        } else if ('fills' in node && Array.isArray(node.fills) && node.fills.length > 0) {
          content = 'Filled shape';
        } else {
          content = node.type;
        }

        return {
          id: node.id,
          index: index,
          type: node.type,
          content: content,
        };
      });

      const prompt = `Rename the following UI layers based on their context:

${layerData.map((item: { type: string; content: string }, i: number) => `${i + 1}. ${item.type} - "${item.content}"`).join('\n')}

Provide concise and descriptive names for each layer. The response should be in the format:
1. NewNameOne
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
        const match = line.match(/^\d+\.\s*(.+)$/);
        return match ? match[1].trim() : null;
      }).filter((name: string | null): name is string => name !== null);

      if (newNames.length === 0) {
        throw new Error('Failed to parse AI response');
      }

      allLayers.forEach((node: SceneNode, index: number) => {
        if (newNames[index]) {
          node.name = newNames[index];
        }
        figma.ui.postMessage({ type: 'progress', current: index + 1, total: allLayers.length });
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
    figma.ui.postMessage({ 
      type: 'selectionUpdate', 
      layerCount: selectedLayers.length 
    });
  }
};


