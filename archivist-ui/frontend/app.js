const React = require("react");
const ReactDOM = require("react-dom");
const { chain, identity } = require("lodash");
const { shell } = require("electron");
const { spawn } = require("child_process");

const {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Masonry
} = require("react-virtualized");

const { useState, useEffect, useCallback, useRef } = React;

const SPACER = 10;

const talkToProcess = async (command, args) => {
  return new Promise(resolve => {
    const process = spawn(
      "node",
      args ? ["./process.js", command, args] : ["./process.js", command]
    );

    let data = "";

    process.stdout.on("data", d => {
      data += d.toString();
    });

    process.stderr.on("data", data => {
      console.log("[stderr]", data.toString());
    });

    process.on("exit", () => {
      resolve(JSON.parse(data));
    });
  });
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400) - SPACER;
};

const HoverInfo = ({ meta, link, img }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
    {meta.title && (
      <a
        className="f6 mb2 lh-title no-underline underline-hover white db"
        href="#"
        onClick={() => shell.openExternal(link)}
      >
        {meta.title}
      </a>
    )}

    {meta.note && <div className="mb2 lh-copy">{meta.note}</div>}

    {meta.tags && (
      <div className="light-gray">{meta.tags.map(t => `#${t}`).join(", ")}</div>
    )}

    <div className="mt2">
      {[
        ["src", () => shell.openExternal(link)],
        meta.static && ["frozen", () => shell.openItem(meta.static)],
        ["img", () => shell.openItem(img)]
      ]
        .filter(identity)
        .map(([text, callback]) => (
          <a
            key={text}
            className="link dim br2 ph2 pv1 dib white bg-mid-gray mr1"
            href="#"
            onClick={callback}
          >
            {text}
          </a>
        ))}
    </div>
  </div>
);

const createCellRenderer = ({
  data,
  width,
  cache,
  setHoveredId,
  hoveredId
}) => ({ index, key, parent, style }) => {
  const columnWidth = calcColumnWidth({ width });
  const datum = data[index];
  const ratio = datum.height / datum.width;

  return (
    <CellMeasurer cache={cache.current} index={index} key={key} parent={parent}>
      <div
        style={style}
        className="h-100"
        onMouseEnter={() => {
          setHoveredId(datum.id);
        }}
        onMouseLeave={() => {
          setHoveredId(null);
        }}
      >
        <div
          className="h-100 relative"
          style={{
            height: ratio * columnWidth,
            width: columnWidth,
            backgroundImage: `url("${datum.img}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center"
          }}
        >
          {hoveredId === datum.id && <HoverInfo {...datum} />}
        </div>
      </div>
    </CellMeasurer>
  );
};

const App = () => {
  const [data, setData] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);
  const masonry = useRef(null);

  const cache = useRef(
    new CellMeasurerCache({
      defaultHeight: 400,
      defaultWidth: 400,
      fixedWidth: true
    })
  );

  const cellPositioner = useRef(
    createMasonryCellPositioner({
      cellMeasurerCache: cache.current,
      columnCount: 3,
      columnWidth: 400,
      spacer: SPACER
    })
  );

  useEffect(() => {
    talkToProcess("query").then(data => {
      const finalData = chain(data)
        .map(d => ({ ...d, time: new Date(d.time) }))
        .sortBy(d => d.time)
        .reverse()
        .value();

      setData(finalData);
    });
  }, []);

  const onResize = useCallback(({ width }) => {
    const columnWidth = calcColumnWidth({ width });
    const columnCount = Math.floor(Math.max(width / columnWidth, 1));

    cache.current.clearAll();

    cellPositioner.current.reset({
      columnCount,
      columnWidth,
      spacer: SPACER
    });

    masonry.current.clearCellPositions();
  });

  return (
    <div className="sans-serif w-100 vh-100 bg-light-gray">
      <AutoSizer onResize={onResize} style={{ outline: "none" }}>
        {({ width, height }) => (
          <Masonry
            style={{ padding: SPACER }}
            overscanByPixels={300}
            ref={masonry}
            cellCount={data.length}
            cellMeasurerCache={cache.current}
            cellPositioner={cellPositioner.current}
            cellRenderer={createCellRenderer({
              data,
              width,
              cache,
              setHoveredId,
              hoveredId
            })}
            width={width}
            height={height}
          />
        )}
      </AutoSizer>
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("app"));
