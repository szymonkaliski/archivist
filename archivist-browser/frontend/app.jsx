import React, { useState, useEffect } from "react";
import { minBy, maxBy, range } from "lodash";

const DumbVis = ({ items }) => {
  const SCALE = 0.01;
  const CANVAS_SIZE = 1600;

  const embeddings = items.map((d) => d.embedding);

  const xMin = minBy(embeddings, (d) => d[0])[0];
  const xMax = maxBy(embeddings, (d) => d[0])[0];
  const yMin = minBy(embeddings, (d) => d[1])[1];
  const yMax = maxBy(embeddings, (d) => d[1])[1];

  return (
    <div>
      {items.map((d, i) => {
        const w = d.width * SCALE;
        const h = d.height * SCALE;
        const x = ((embeddings[i][0] - xMin) / (xMax - xMin)) * CANVAS_SIZE;
        const y = ((embeddings[i][1] - yMin) / (yMax - yMin)) * CANVAS_SIZE;

        return (
          <div
            key={d.meta.source + "-" + d.id}
            className="absolute"
            style={{
              top: x,
              left: y,
              width: w,
              height: h,
            }}
          >
            <img src={`/api/image-thumbnail/${encodeURIComponent(d.img)}`} />
          </div>
        );
      })}
    </div>
  );
};

const App = () => {
  const [data, setData] = useState([]);

  useEffect(() => {
    fetch("/api/search")
      .then((res) => res.json())
      .then((res) => {
        setData(
          res.items.map((d, i) => {
            d.embedding = res.embedding[i];
            return d;
          })
        );
      });
  }, []);

  return (
    <div className="sans-serif pa2">
      <div>
        <div>{data.length}</div>
      </div>
      {data.length > 0 && <DumbVis items={data} />}
    </div>
  );
};

export default App;
