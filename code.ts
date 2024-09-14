const OPENROUTER_API_KEY = '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';

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  children: LayerInfo[];
}

const systemMessage = `You are an AI assistant specialized in renaming Figma layers.
Your task is to provide concise and descriptive names for each layer based on their context, hierarchy, and type.
Analyze the structure and content of the layers to determine appropriate names.
Provide names that reflect the purpose and content of each element.
The response should be a JSON object with layer IDs as keys and new names as values. Only respond with JSON and nothing else!!!`;

figma.showUI(__html__);

function getLayerInfo(node: SceneNode): LayerInfo {
  const info: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    children: [],
  };

  if ('children' in node) {
    info.children = node.children.map(getLayerInfo);
  }

  return info;
}

function countLayers(layerInfo: LayerInfo): number {
  return 1 + layerInfo.children.reduce((sum, child) => sum + countLayers(child), 0);
}

function countTokens(text: string): number {
  return text.split(/\s+/).length;
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = inputTokens * 0.00003;
  const outputCost = outputTokens * 0.00006;
  return inputCost + outputCost;
}

async function renameLayerRecursively(layerInfo: LayerInfo, newNames: Record<string, string>) {
  if (layerInfo.id in newNames) {
    const node = await figma.getNodeByIdAsync(layerInfo.id);
    if (node) {
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

figma.on('selectionchange', () => {
  updateSelectionInfo();
});

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

    const layerInfos = selection.map(getLayerInfo);
    console.log('Layer infos:', layerInfos);

    const totalLayers = layerInfos.reduce((sum, info) => sum + countLayers(info), 0);
    console.log('Total layers:', totalLayers);

    figma.ui.postMessage({ type: 'layerCount', count: totalLayers });

    const temperature = msg.temperature || 0.7;
    console.log('Temperature:', temperature);

    const inputTokens = countTokens(JSON.stringify(layerInfos));
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
          model: 'meta-llama/llama-3.1-8b-instruct:free',
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

      const data = await response.json();
      console.log('Parsed API response:', data);

      const aiResponse = data.choices[0].message.content;
      console.log('AI response:', aiResponse);

      try {
        let jsonContent: string;
        // Проверяем, начинается ли ответ с '{'
        if (aiResponse.trim().startsWith('{')) {
          jsonContent = aiResponse.trim();
        } else {
          // Если нет, ищем JSON в ответе AI
          const jsonMatch = aiResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
          if (!jsonMatch) {
            throw new Error('Could not find JSON in AI response');
          }
          jsonContent = jsonMatch[1];
        }

        console.log('Extracted JSON content:', jsonContent);

        const newNames = JSON.parse(jsonContent);
        console.log('Parsed names:', newNames);

        if (typeof newNames !== 'object' || newNames === null) {
          throw new Error('Invalid JSON structure in AI response');
        }

        // Прове��ка на пустой объект
        if (Object.keys(newNames).length === 0) {
          throw new Error('AI response contains an empty JSON object');
        }

        const outputTokens = countTokens(aiResponse);
        console.log(`Estimated output tokens: ${outputTokens}`);

        const estimatedCost = estimateCost(inputTokens, outputTokens);
        console.log(`Estimated cost: $${estimatedCost.toFixed(6)}`);

        figma.ui.postMessage({ 
          type: 'tokenInfo', 
          inputTokens, 
          outputTokens, 
          estimatedCost: estimatedCost.toFixed(6) 
        });

        // Переименование слоев
        for (const layerInfo of layerInfos) {
          await renameLayerRecursively(layerInfo, newNames);
        }

        figma.ui.postMessage({ type: 'complete' });

      } catch (jsonError: unknown) {
        console.error('JSON parsing error:', jsonError);
        if (jsonError instanceof Error) {
          figma.ui.postMessage({ type: 'error', message: 'Failed to parse AI response: ' + jsonError.message });
        } else {
          figma.ui.postMessage({ type: 'error', message: 'Failed to parse AI response: Unknown error' });
        }
        return;
      }

    } catch (error) {
      console.error('Fetch error:', error);
      if (error instanceof Error) {
        figma.ui.postMessage({ type: 'error', message: error.message });
      } else {
        figma.ui.postMessage({ type: 'error', message: 'An unknown error occurred' });
      }
    }
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};