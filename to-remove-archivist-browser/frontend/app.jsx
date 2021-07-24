import React, {
  Suspense,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  Canvas,
  ReactThreeFiber,
  useFrame,
  extend,
  useThree,
} from "@react-three/fiber";
import { minBy, maxBy, range, last } from "lodash";
import { NoToneMapping, NearestFilter, Texture, MOUSE } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { useTexture } from "@react-three/drei";
import { ErrorBoundary } from "react-error-boundary";

extend({ OrbitControls });

const SCALE = 0.05;
const CANVAS_SIZE = 10000;

const Controls = () => {
  const { camera, gl } = useThree();

  return (
    <orbitControls
      enablePan
      enableRotate={false}
      enableZoom
      args={[camera, gl.domElement]}
      mouseButtons={{
        LEFT: MOUSE.PAN,
      }}
    />
  );
};

const DataTexture = ({ dataUrl }) => {
  const map = useTexture(dataUrl);

  return <meshBasicMaterial map={map} transparent={false} />;
};

const intersectRect = (r1, r2) => {
  return !(
    r2.x > r1.x + r1.w ||
    r2.x + r2.w < r1.x ||
    r2.y > r1.y + r1.h ||
    r2.y + r2.h < r1.y
  );
};

const RenderItem = ({ item, embeddingsSpan, position, viewport, zoom }) => {
  const w = item.width * SCALE;
  const h = item.height * SCALE;

  const x =
    ((item.embedding[0] - embeddingsSpan.x) / embeddingsSpan.w) * CANVAS_SIZE;
  const y =
    ((item.embedding[1] - embeddingsSpan.y) / embeddingsSpan.h) * CANVAS_SIZE;

  const vx = position.x;
  const vy = position.y;
  const vw = viewport.width / zoom;
  const vh = viewport.height / zoom;

  const isVisible = intersectRect(
    { x: x - w / 2, y: y - h / 2, w, h },
    { x: vx - vw / 2, y: vy - vh / 2, w: vw, h: vh }
  );

  const encoded = encodeURIComponent(item.img);

  const imgUrlMicro = `/api/image-micro/${encoded}`;
  const imgUrlThumbnail = `/api/image-thumbnail/${encoded}`;
  const imgUrlMedium = `/api/image-medium/${encoded}`;
  const imgUrlFull = `/api/image-full/${encoded}`;

  let dataUrl = imgUrlMicro;

  if (isVisible) {
    if (zoom > 0.5) {
      dataUrl = imgUrlThumbnail;
    }

    if (zoom > 10) {
      dataUrl = imgUrlMedium;
    }

    if (zoom > 15) {
      dataUrl = imgUrlFull;
    }
  }

  return (
    <mesh position={[x, y, 0]}>
      <planeBufferGeometry args={[w, h]} />

      {isVisible ? (
        <ErrorBoundary fallback={<meshBasicMaterial color={0xff0000} />}>
          <Suspense fallback={<meshBasicMaterial color={0xeeeeee} />}>
            <DataTexture key={dataUrl} dataUrl={dataUrl} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <meshBasicMaterial color={0xeeeeee} />
      )}
    </mesh>
  );
};

let c = 0;

const Wrapper = ({ items, embeddingsSpan }) => {
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useFrame(({ camera, viewport }) => {
    if (c++ % 16 === 0) {
      setZoom(camera.zoom);
      setPosition({ x: camera.position.x, y: camera.position.y });
      setViewport({ width: viewport.width, height: viewport.height });
    }
  });

  console.log("zoom:", zoom, "position:", position.x, position.y);

  return items.map((item) => (
    <RenderItem
      key={item.source + "-" + item.id}
      item={item}
      embeddingsSpan={embeddingsSpan}
      zoom={zoom}
      position={position}
      viewport={viewport}
    />
  ));
};

const Render = ({ items, embeddingsSpan }) => {
  const onCreated = useCallback(({ gl, camera }) => {
    gl.toneMapping = NoToneMapping;
  }, []);

  return (
    <Canvas
      concurrent
      orthographic
      pixelRatio={window.devicePixelRatio}
      onCreated={onCreated}
      style={{ position: "fixed" }}
    >
      <Controls />

      <Wrapper items={items} embeddingsSpan={embeddingsSpan} />
    </Canvas>
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
