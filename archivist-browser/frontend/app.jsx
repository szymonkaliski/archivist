import React, { useState, useEffect } from "react";
import { minBy, maxBy, range } from "lodash";
import { Sprite, Stage } from "react-pixi-fiber";
import { useWindowSize } from "@react-hook/window-size";
import { Texture } from "pixi.js";

const SCALE = 0.01;
const CANVAS_SIZE = 2000;

const RenderItem = ({ item, embeddingsSpan }) => {
  const [texture, setTexture] = useState(null);

  const w = item.width * SCALE;
  const h = item.height * SCALE;

  const x =
    ((item.embedding[0] - embeddingsSpan.x) / embeddingsSpan.w) * CANVAS_SIZE;
  const y =
    ((item.embedding[1] - embeddingsSpan.y) / embeddingsSpan.h) * CANVAS_SIZE;

  useEffect(() => {
    Texture.fromURL(`/api/image-thumbnail/${encodeURIComponent(item.img)}`)
      .then((texture) => {
        setTexture(texture);
      })
      .catch((e) => {
        console.log("texture loading error", item, e);
      });
  }, [item.img]);

  if (!texture) {
    return null;
  }

  return <Sprite texture={texture} x={x} y={y} width={w} height={h} />;
};

const Render = ({ items, embeddingsSpan }) => {
  // const [width, height] = useWindowSize();
  const [width, height] = [CANVAS_SIZE, CANVAS_SIZE];

  return (
    <Stage options={{ width, height, backgroundColor: 0xfafafa }}>
      {items.map((item, i) => {
        return (
          <RenderItem key={i} item={item} embeddingsSpan={embeddingsSpan} />
        );
      })}
    </Stage>
  );
};

const App = () => {
  const [data, setData] = useState([]);

  useEffect(() => {
    if (data.length > 0) {
      return;
    }

    console.time("fetch");

    fetch("/api/search")
      .then((res) => res.json())
      .then((res) => {
        setData(
          res.items.map((d, i) => {
            d.embedding = res.embedding[i];
            return d;
          })
        );

        console.timeEnd("fetch");
      });
  }, []);

  const embeddings = data.map((d) => d.embedding);

  let embeddingsSpan = { x: 0, y: 0, w: 0, h: 0 };

  if (embeddings.length > 0) {
    const xMin = minBy(embeddings, (d) => d[0])[0];
    const xMax = maxBy(embeddings, (d) => d[0])[0];
    const yMin = minBy(embeddings, (d) => d[1])[1];
    const yMax = maxBy(embeddings, (d) => d[1])[1];

    embeddingsSpan.x = xMin;
    embeddingsSpan.y = yMin;
    embeddingsSpan.w = xMax - xMin;
    embeddingsSpan.h = yMax - yMin;
  }

  return (
    <div>
      <div className="absolute pa2 bg-light-gray code f7">
        <div>items: {data.length}</div>
      </div>

      {data.length > 0 && (
        <Render items={data} embeddingsSpan={embeddingsSpan} />
      )}
    </div>
  );
};

export default App;
