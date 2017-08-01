<html>
<body>

<?php 
$data = $_POST["xml"];
echo "Saved.";
$fname = "upload/abc.xml";//generates random name

$file = fopen($fname, 'w');//creates new file
fwrite($file, $data);
fclose($file);
?><br>

</body>
</html>
