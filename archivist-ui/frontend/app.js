const React = require("react");
const ReactDOM = require("react-dom");
const { chain } = require("lodash");
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

const App = () => {
  const [data, setData] = useState([]);
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

  const createCellRenderer = ({ width }) => ({ index, key, parent, style }) => {
    const columnWidth = calcColumnWidth({ width });
    const datum = data[index];
    const ratio = datum.height / datum.width;

    return (
      <CellMeasurer
        cache={cache.current}
        index={index}
        key={key}
        parent={parent}
      >
        <div style={style} className="h-100">
          <div
            className="h-100"
            style={{
              height: ratio * columnWidth,
              width: columnWidth,
              backgroundImage: `url("${datum.img}")`,
              backgroundSize: "contain",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center"
            }}
          />
        </div>
      </CellMeasurer>
    );
  };

  return (
    <div
      className="sans-serif w-100 vh-100 bg-light-gray"
      style={{ padding: SPACER }}
    >
      <AutoSizer onResize={onResize} style={{ outline: "none" }}>
        {({ width, height }) => (
          <Masonry
            ref={masonry}
            cellCount={data.length}
            cellMeasurerCache={cache.current}
            cellPositioner={cellPositioner.current}
            cellRenderer={createCellRenderer({ width })}
            width={width}
            height={height}
          />
        )}
      </AutoSizer>
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("app"));
