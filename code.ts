const OPENROUTER_API_KEY = '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';

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  children: LayerInfo[];
  [key: string]: any;
}

const systemMessage = `You are an AI assistant specialized in renaming Figma layers.
Your task is to provide concise and descriptive names for each layer based on their context, hierarchy, and type.
Analyze the structure and content of the layers to determine appropriate names.
Provide names that reflect the purpose and content of each element.
The response should be a JSON object with layer IDs as keys and new names as values.`;

figma.showUI(__html__);

function getLayerInfo(node: SceneNode): LayerInfo {
  const info: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    children: [],
  };

  if ('children' in node) {
    info.children = (node.children as SceneNode[]).map(getLayerInfo);
  }

  if (node.type === 'TEXT') {
    info.characters = node.characters;
  }

  return info;
}

function countLayers(layerInfo: LayerInfo): number {
  return 1 + layerInfo.children.reduce((sum, child) => sum + countLayers(child), 0);
}

function countTokens(text: string): number {
  // Это простая оценка, не точная для всех моделей
  return text.split(/\s+/).length;
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  // Обновите эти значения в соответствии с актуальной ценовой политикой
  const inputCost = inputTokens * 0.00003;
  const outputCost = outputTokens * 0.00006;
  return inputCost + outputCost;
}

async function renameLayerRecursively(layerInfo: LayerInfo, newNames: Record<string, string>) {
  if (layerInfo.id in newNames) {
    const node = await figma.getNodeByIdAsync(layerInfo.id);
    if (node) {
      if ('fontName' in node && node.type === 'TEXT') {
        await figma.loadFontAsync(node.fontName as FontName);
      }
      node.name = newNames[layerInfo.id];
    }
  }

  for (const child of layerInfo.children) {
    await renameLayerRecursively(child, newNames);
  }
}

function updateSelectionInfo() {
  const selection = figma.currentPage.selection;
  const selectedLayers = selection.length;
  const totalLayers = selection.reduce((sum, node) => sum + countLayers(getLayerInfo(node)), 0);
  
  figma.ui.postMessage({ 
    type: 'selectionUpdate', 
    selectedCount: selectedLayers,
    totalCount: totalLayers
  });
}

// Вызывайте эту функцию при запуске плагина и при изменении выделения
figma.on('selectionchange', () => {
  updateSelectionInfo();
});

// Вызовите функцию сразу при запуске плагина
updateSelectionInfo();

figma.ui.onmessage = async (msg: { type: string; temperature?: number }) => {
  console.log('Received message:', msg);
  if (msg.type === 'start-renaming') {
    const selection = figma.currentPage.selection;
    console.log('Current selection:', selection);

    if (selection.length === 0) {
      console.log('No layers selected');
      figma.ui.postMessage({ type: 'complete', message: 'No layers selected' });
      return;
    }

    const layerInfos = selection.map(node => getLayerInfo(node));
    console.log('Layer infos:', layerInfos);

    const totalLayers = layerInfos.reduce((sum, info) => sum + countLayers(info), 0);
    console.log('Total layers:', totalLayers);

    figma.ui.postMessage({ type: 'layerCount', count: totalLayers });

    const temperature = msg.temperature || 0.85;
    console.log('Temperature:', temperature);

    const payload = {
      model: 'nousresearch/hermes-3-llama-3.1-405b:free',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: JSON.stringify(layerInfos, null, 2) },
      ],
      temperature: temperature,
    };

    const inputTokens = countTokens(systemMessage) + countTokens(JSON.stringify(layerInfos, null, 2));
    console.log(`Estimated input tokens: ${inputTokens}`);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'Figma AI Rename Layers Plugin',
          'HTTP-Referer': 'https://www.figma.com/'
        },
        body: JSON.stringify({
          model: 'nousresearch/hermes-3-llama-3.1-405b:free',
          messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: JSON.stringify(layerInfos, null, 2) },
          ],
          temperature: temperature,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error('API Error:', errorData);
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const responseText = await response.text();
      console.log('Raw API response:', responseText);

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Error parsing JSON:', parseError);
        throw new Error('Failed to parse API response');
      }

      console.log('Parsed API response:', data);

      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        console.error('Unexpected API response structure:', data);
        throw new Error('Unexpected API response structure');
      }

      const outputTokens = countTokens(data.choices[0].message.content);
      console.log(`Estimated output tokens: ${outputTokens}`);

      const estimatedCost = estimateCost(inputTokens, outputTokens);
      console.log(`Estimated cost: $${estimatedCost.toFixed(6)}`);

      figma.ui.postMessage({ 
        type: 'tokenInfo', 
        inputTokens, 
        outputTokens, 
        estimatedCost: estimatedCost.toFixed(6) 
      });

      const newNames = JSON.parse(data.choices[0].message.content);
      console.log('Parsed names:', newNames);

      for (const layerInfo of layerInfos) {
        await renameLayerRecursively(layerInfo, newNames);
        figma.ui.postMessage({ type: 'progress', current: layerInfos.indexOf(layerInfo) + 1, total: layerInfos.length });
      }

      figma.ui.postMessage({ type: 'complete' });
    } catch (error: unknown) {
      console.error('Fetch error:', error);
      if (error instanceof Error) {
        figma.ui.postMessage({ type: 'error', message: error.message });
      } else {
        figma.ui.postMessage({ type: 'error', message: 'An unknown error occurred' });
      }
    }
  } else if (msg.type === 'cancel') {
    console.log('Cancelling plugin');
    figma.closePlugin();
  } else if (msg.type === 'requestSelection') {
    const selectedLayers = figma.currentPage.selection;
    console.log('Selected layers:', selectedLayers);
    const totalLayers = selectedLayers.reduce((sum, node) => sum + countLayers(getLayerInfo(node)), 0);
    console.log('Total layers (including sublayers):', totalLayers);
    figma.ui.postMessage({ 
      type: 'selectionUpdate', 
      selectedCount: selectedLayers.length,
      totalCount: totalLayers
    });
  }
};