import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import m3u8Parser from "m3u8-parser";
import cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs";

// Altere para o id do filme na apple tv
// Esse id pode ser conseguido na url da página do filme
// Exemplo de url: https://tv.apple.com/br/movie/olhos-famintos-renascimento/umc.cmc.4cqrxmz9zixmwp0zvnp0jk75b
// No link acima o id é o "umc.cmc.4cqrxmz9zixmwp0zvnp0jk75b" no fim da url
const APPLE_TV_ID = "umc.cmc.4cqrxmz9zixmwp0zvnp0jk75b";

// Altere para o tipo de programa.
// Deve ser "movie" para filmes e "show" para séries
const TYPE = "movie";

// Altere para a path do output
const RESULT_NAME = "video.mp4";

fs.unlinkSync(RESULT_NAME);

const appleTvPageUrl = `https://tv.apple.com/br/${TYPE}/${APPLE_TV_ID}`;

const appleTvPageResponse = await fetch(appleTvPageUrl);
const appleTvHtml = await appleTvPageResponse.text();

const $ = cheerio.load(appleTvHtml);
const meta = $("meta[property='og:video']").attr("content");

if (!meta) {
  throw new Error(`O programa não possui um video`);
}

const playlistUrl = `${meta}&webbrowser=true`;

const playlistResponse = await fetch(playlistUrl);
let playlistText = await playlistResponse.text();

playlistText = playlistText.split("\n").slice(0, -1).join("\n");

const parser = new m3u8Parser.Parser();

parser.push(playlistText);

parser.end();

const playlistJson = parser.manifest.playlists;

const videoPlaylistM3u8 = playlistJson.reduce((acc, playlist) => {
  if (playlist.attributes.RESOLUTION.width > acc.attributes.RESOLUTION.width) {
    return playlist;
  }
  return acc;
});
const audioPlaylistM3u8Language =
  parser.manifest.mediaGroups.AUDIO[videoPlaylistM3u8.attributes.AUDIO];

let audioPlaylistM3u8 = Object.values(audioPlaylistM3u8Language).find(
  (al) => al.language === "pt-BR"
);

if (!audioPlaylistM3u8) {
  audioPlaylistM3u8 =
    audioPlaylistM3u8Language[Object.keys(audioPlaylistM3u8Language)[0]];
}

const videoPlaylistResponse = await fetch(videoPlaylistM3u8.uri);
const audioPlaylistResponse = await fetch(audioPlaylistM3u8.uri);

const videoPlaylistText = await videoPlaylistResponse.text();
const audioPlaylistText = await audioPlaylistResponse.text();

const videoPlaylistParser = new m3u8Parser.Parser();
const audioPlaylistParser = new m3u8Parser.Parser();

videoPlaylistParser.push(videoPlaylistText);
audioPlaylistParser.push(audioPlaylistText);

videoPlaylistParser.end();
audioPlaylistParser.end();

const videoSegments = videoPlaylistParser.manifest.segments;
const audioSegments = audioPlaylistParser.manifest.segments;

const videoPartInicialPath = videoSegments[0].map.uri;
const audioPartInicialPath = audioSegments[0].map.uri;

const videoPartsPath = [
  videoPartInicialPath,
  ...videoSegments.map((segment) => segment.uri),
];
const audioPartsPath = [
  audioPartInicialPath,
  ...audioSegments.map((segment) => segment.uri),
];

const videoPlaylistM3BaseUrl = videoPlaylistM3u8.uri
  .split("/")
  .slice(0, -1)
  .join("/");
const audioPlaylistM3BaseUrl = audioPlaylistM3u8.uri
  .split("/")
  .slice(0, -1)
  .join("/");

const videoPartsUrl = videoPartsPath.map(
  (partPath) => `${videoPlaylistM3BaseUrl}/${partPath}`
);
const audioPartsUrl = audioPartsPath.map(
  (partPath) => `${audioPlaylistM3BaseUrl}/${partPath}`
);

let videoBlob = new Blob();
for (let i = 0; i < videoPartsUrl.length; i++) {
  const videoPartUrl = videoPartsUrl[i];
  console.log(
    `VIDEO:[${i + 1}/${videoPartsUrl.length}] buscando parte ${videoPartUrl}...`
  );
  const response = await fetch(videoPartUrl);
  console.log(
    `VIDEO:[${i + 1}/${
      videoPartsUrl.length
    }] encontrado, transformando em blob...`
  );
  const partBlob = await response.arrayBuffer();
  console.log(
    `VIDEO:[${i + 1}/${
      videoPartsUrl.length
    }] blob transformado, concatenando...`
  );
  videoBlob = new Blob([videoBlob, partBlob], { type: "video/mp4" });
  console.log(
    `VIDEO:[${i + 1}/${
      videoPartsUrl.length
    }] o processo para essa parte terminou!`
  );
}

let audioBlob = new Blob();
for (let i = 0; i < audioPartsUrl.length; i++) {
  const audioPartUrl = audioPartsUrl[i];
  console.log(
    `AUDIO:[${i + 1}/${audioPartsUrl.length}] buscando parte ${audioPartUrl}...`
  );
  const response = await fetch(audioPartUrl);
  console.log(
    `AUDIO:[${i + 1}/${
      audioPartsUrl.length
    }] encontrado, transformando em blob...`
  );
  const partBlob = await response.arrayBuffer();
  console.log(
    `AUDIO:[${i + 1}/${
      audioPartsUrl.length
    }] blob transformado, concatenando...`
  );
  audioBlob = new Blob([audioBlob, partBlob], {
    type: "audio/mpeg",
  });
  console.log(
    `AUDIO:[${i + 1}/${
      audioPartsUrl.length
    }] o processo para essa parte terminou!`
  );
}

const tempDir = path.join(".", "temp");

if (!fs.existsSync(tempDir)) {
  console.log("Criando pasta temporária para armazenar os arquivos");
  fs.mkdirSync(tempDir);
}

console.log(`Pasta temporário pronta: ${tempDir}`);

const videoTempPath = path.join(tempDir, `${Date.now()}-video.mp4`);

console.log(`Salvando vídeo temporário em: ${videoTempPath}`);
await saveBlobFile(videoBlob, videoTempPath);

const audioTempPath = path.join(tempDir, `${Date.now()}-audio.mp3`);

console.log(`Salvando audio temporário em: ${audioTempPath}`);
await saveBlobFile(audioBlob, audioTempPath);

const ffmpegCommand = `${ffmpegPath} -i ${videoTempPath} -i ${audioTempPath} -c:v copy -c:a aac -strict experimental ${RESULT_NAME}`;

console.log("Juntando vídeo com o audio");
const ffmpegProcess = spawn(ffmpegCommand, { shell: true });

ffmpegProcess.stderr.on("data", (data) => {
  const logString = data.toString().trim();

  if (!logString.startsWith("frame=")) {
    return;
  }

  console.log(logString);
});

ffmpegProcess.on("exit", () => {
  deleteTempFolder();
  console.log(`Processo finalizado. vídeo salvo em: ${RESULT_NAME}`);
});

function deleteTempFolder() {
  console.log("Deletando pasta temporária");
  fs.rmSync(tempDir, { recursive: true });
}

async function saveBlobFile(blob, output) {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(output, buffer);
}
