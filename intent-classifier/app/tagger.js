/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as useLoader from '@tensorflow-models/universal-sentence-encoder';
import * as tf from '@tensorflow/tfjs';
import * as d3 from 'd3';


const EMBEDDING_DIM = 512;
const ONES = tf.ones([EMBEDDING_DIM]);

let use;
async function loadUSE() {
  if (use == null) {
    use = await useLoader.load();
  }
  return use;
}

const modelUrls = {
  'bidirectional-lstm': './models/bidirectional-tagger/model.json',
  'lstm': './models/lstm-tagger/model.json',
  'weighted-lstm': './models/weighted-tagger/model.json',
  'dense': './models/dense/model.json',
};

const taggers = {};
async function loadTagger(name) {
  if (taggers[name] == null) {
    const url = modelUrls[name];
    try {
      taggers[name] = await tf.loadLayersModel(url);
      document.getElementById(name).disabled = false;
    } catch (e) {
      // Could not load that model. This is not necessarily an error
      // as the user may not have trained all the available model types
      console.log(`Could not load "${name}" model`);
    }
  }
  return taggers[name];
}


async function loadMetadata(name) {
  const metadataUrl =
      modelUrls[name].replace('model.json', 'tagger_metadata.json');
  const resp = await fetch(metadataUrl);
  return resp.json();
}


// Load the models and allow the browser to cache them.
async function loadModels() {
  const modelLoadPromises = Object.keys(modelUrls).map(loadTagger);
  return await Promise.all([loadUSE(), ...modelLoadPromises]);
}

/**
 * Split an input string into tokens, we use the same tokenization function
 * as we did during training.
 * @param {string} input
 */
function tokenizeSentence(input) {
  return input.split(/\b/).map(t => t.trim()).filter(t => t.length !== 0);
}

async function tagTokens(sentence, model = 'bidirectional-lstm') {
  const [use, tagger, metadata] =
      await Promise.all([loadUSE(), loadTagger(model), loadMetadata(model)]);
  const {labels, sequenceLength} = metadata;

  const tokenized = tokenizeSentence(sentence).slice(0, sequenceLength);
  console.time(`Embedding ${tokenized.length} tokens`);
  console.log('before embed', tf.memory());
  const activations = await use.embed(tokenized);
  console.log('after embed', tf.memory());
  console.timeEnd(`Embedding ${tokenized.length} tokens`);

  // Pad the tensor if needed
  const toPad = sequenceLength - tokenized.length;
  // Reuse the same padding tensor to save memory.
  const padTensors =
      tf.tidy(() => tf.stack(Array(toPad).fill(0).map(_ => ONES)))

  const padded = activations.concat(padTensors);
  const batched = tf.stack([padded]);

  const prediction = tagger.predict(batched);
  let predsArr = (await prediction.array())[0];

  // Add padding 'tokens' to the end of the values that will be displayed
  // in the UI. These are there for illustration.
  if (tokenized.length < sequenceLength) {
    tokenized.push(labels[2])
    predsArr = predsArr.slice(0, tokenized.length);
  }
  const slicedEmbeddings = padded.slice([0], [tokenized.length]);
  const tokenEmbeddingsArr = await slicedEmbeddings.array();

  tf.dispose(
      [activations, padTensors, padded, batched, prediction, slicedEmbeddings]);

  console.log('before return', tf.memory());
  return {
    tokenized: tokenized,
    tokenScores: predsArr,
    tokenEmbeddings: tokenEmbeddingsArr,
  };
}


async function displayTokenization(
    tokens, tokenScores, tokenEmbeddings, model) {
  const resultsDiv = document.createElement('div');
  resultsDiv.classList = `tagging`;
  resultsDiv.innerHTML = `<p class="model-type ${model}">${model}</p>`

  displayTokens(tokens, resultsDiv);
  displayEmbeddingsPlot(tokenEmbeddings, resultsDiv);
  displayTags(tokenScores, resultsDiv, model);


  document.getElementById('taggings').appendChild(resultsDiv);
}


function displayTokens(tokens, parentEl) {
  const tokensDiv = document.createElement('div');
  tokensDiv.classList = `tokens`;
  tokensDiv.innerHTML =
      tokens.map(token => `<div class="token">${token}</div>`).join('\n');
  parentEl.appendChild(tokensDiv);
}

const embeddingCol =
    d3.scaleSequential(d3.interpolateSpectral).domain([-0.075, 0.075]);
embeddingCol.clamp(true);


function displayEmbeddingsPlot(embeddings, parentEl) {
  const embeddingDiv = document.createElement('div');
  embeddingDiv.classList = `embeddings`;

  embeddingDiv.innerHTML =
      embeddings
          .map(embedding => {
            const embeddingValDivs = embedding.slice(0, 340).map(val => {
              return `<div class="embVal" ` +
                  `style="background-color:${embeddingCol(val)} "` +
                  `title="${val}"` +
                  `></div>`;
            });

            return `<div class="embedding">${
                embeddingValDivs.join('\n')}</div>`;
          })
          .join('\n');

  parentEl.appendChild(embeddingDiv);
}

async function displayTags(tokenScores, parentEl, modelName) {
  const metadata = await loadMetadata(modelName);
  const {labels} = metadata;

  const tagsDiv = document.createElement('div');
  tagsDiv.classList = `tags`;

  tagsDiv.innerHTML =
      tokenScores
          .map(scores => {
            const maxIndex = scores.indexOf(Math.max(...scores));
            const token = labels[maxIndex];
            const tokenScore = (scores[maxIndex] * 100).toPrecision(3);
            return `<div class="tag ${token}">` +
                `&nbsp;&nbsp;${token.replace(/__/g, '')}<sup>${
                       tokenScore}%</sup></div>`;
          })
          .join('\n');
  parentEl.appendChild(tagsDiv);
}

async function onSendMessage(inputText, model) {
  if (inputText != null && inputText.length > 0) {
    const result = await tagTokens(inputText, model);
    const {tokenized, tokenScores, tokenEmbeddings} = result;
    displayTokenization(tokenized, tokenScores, tokenEmbeddings, model);
  }
}

function setupListeners() {
  const form = document.getElementById('textentry');
  const textbox = document.getElementById('textbox');
  const modelSelect = document.getElementById('model-select');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const inputText = textbox.value;
    const model = modelSelect.options[modelSelect.selectedIndex].value;


    onSendMessage(inputText, model);
    textbox.value = '';
  }, false);
}

window.addEventListener('load', function() {
  setupListeners();
  loadModels();
});


async function warmup() {
  onSendMessage('What is the weather in Cambridge MA?', 'bidirectional-lstm');
}
