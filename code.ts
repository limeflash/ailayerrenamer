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

type CustomLayerType = 'ICON' | 'IMAGE' | 'VECTOR' | SceneNode['type'];

interface LayerInfo {
  id: string;
  name: string;
  type: SceneNode['type'];
  customType?: CustomLayerType;
  content?: string;
  children: LayerInfo[];
}

function getLayerInfo(node: SceneNode): LayerInfo {
  const layerInfo: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    children: []
  };

  // Определение customType
  if (node.type === 'VECTOR' || node.type === 'STAR' || node.type === 'LINE' || node.type === 'ELLIPSE' || node.type === 'POLYGON') {
    layerInfo.customType = 'VECTOR';
  } else if (node.type === 'RECTANGLE') {
    layerInfo.customType = node.cornerRadius !== figma.mixed && node.cornerRadius > 0 ? 'ICON' : 'IMAGE';
  } else if (node.type === 'TEXT') {
    layerInfo.content = node.characters;
  }

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

function parseAIResponse(aiMessage: string): { level: string; name: string }[] {
  const lines = aiMessage.trim().split('\n');
  const names: { level: string; name: string }[] = [];

  lines.forEach(line => {
    const match = line.match(/^(\s*)(\d+(\.\d+)*)\s*\.?\s*(.+)$/);
    if (match) {
      const [, , level, , name] = match;
      names.push({
        level: level,
        name: name.trim()
      });
    }
  });

  return names;
}

async function renameLayer(layerInfo: LayerInfo, names: { level: string; name: string }[], path: number[] = []) {
  console.log(`Attempting to rename layer: ${layerInfo.name} with path ${path.join('.')}`);
  
  const exactMatch = names.find(n => n.level === path.join('.'));
  
  if (exactMatch) {
    console.log(`Found exact match: ${exactMatch.name} for level: ${exactMatch.level}`);
    try {
      const node = await figma.getNodeByIdAsync(layerInfo.id);
      if (node) {
        console.log(`Renaming node ${node.name} to ${exactMatch.name}`);
        if ('fontName' in node && node.type === 'TEXT') {
          await figma.loadFontAsync(node.fontName as FontName);
        }
        node.name = exactMatch.name;
      } else {
        console.error(`Node not found for id: ${layerInfo.id}`);
      }
    } catch (error) {
      console.error(`Error getting or renaming node: ${error}`);
    }
  } else {
    // Если точное соответствие не найдено, ищем ближайшее соответствие
    const closestMatch = names.reduce((closest, current) => {
      const currentLevels = current.level.split('.').map(Number);
      if (currentLevels.every((level, index) => path[index] === level) && 
          currentLevels.length > closest.level.split('.').length) {
        return current;
      }
      return closest;
    }, names[0]);

    if (closestMatch) {
      console.log(`Found closest match: ${closestMatch.name} for level: ${closestMatch.level}`);
      try {
        const node = await figma.getNodeByIdAsync(layerInfo.id);
        if (node) {
          const remainingPath = path.slice(closestMatch.level.split('.').length);
          const newName = remainingPath.length > 0 ? `${closestMatch.name} ${remainingPath.join('.')}` : closestMatch.name;
          console.log(`Renaming node ${node.name} to ${newName}`);
          if ('fontName' in node && node.type === 'TEXT') {
            await figma.loadFontAsync(node.fontName as FontName);
          }
          node.name = newName;
        } else {
          console.error(`Node not found for id: ${layerInfo.id}`);
        }
      } catch (error) {
        console.error(`Error getting or renaming node: ${error}`);
      }
    } else {
      console.log(`No match found for layer: ${layerInfo.name} at path ${path.join('.')}`);
    }
  }

  // Рекурсивно обрабатываем дочерние слои
  for (let i = 0; i < layerInfo.children.length; i++) {
    await renameLayer(layerInfo.children[i], names, [...path, i + 1]);
  }
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
The selected elements are part of the UI components. 
Please consider the following when renaming:
- Elements marked as IMAGE are image layers
- Elements marked as VECTOR are vector shapes or paths
- Elements marked as ICON are likely icons (vectors wrapped in frames)
- Text layers will have their content included
Please provide descriptive names based on the purpose and content of each element.`;

      const prompt = `${contextDescription}

Rename the following UI layers based on their context, hierarchy, and type:

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

      console.log('AI response:', aiMessage);

      const newNames = parseAIResponse(aiMessage);
      console.log('Parsed names:', newNames);

      if (newNames.length === 0) {
        throw new Error('Failed to parse AI response');
      }

      for (let index = 0; index < layerInfos.length; index++) {
        const layerInfo = layerInfos[index];
        console.log(`Processing root layer: ${layerInfo.name}`);
        console.log('Layer structure:', JSON.stringify(layerInfo, null, 2));
        await renameLayer(layerInfo, newNames, [index + 1]);
        figma.ui.postMessage({ type: 'progress', current: index + 1, total: layerInfos.length });
      }

      figma.ui.postMessage({ type: 'complete' });
    } catch (error: unknown) {
      console.error('Error:', error);
      figma.ui.postMessage({ type: 'error', message: (error instanceof Error ? error.message : String(error)) });
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


