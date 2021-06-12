import React, { useEffect } from "react";

const App = () => {
  useEffect(() => {
    fetch("/api/search")
      .then((res) => res.json())
      .then((res) => {
        console.log({ res });
      });
  }, []);

  return <div className="sans-serif pa2">OK</div>;
};

export default App;
